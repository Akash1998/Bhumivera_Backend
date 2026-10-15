'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const pool = require('../config/db');

const { maskPII, sanitizeObjectPII } = require('../utils/piiMasker');
const { computeQuantumHash512, verifyQuantumSignature, encryptQuantumPayload, decryptQuantumPayload } = require('../utils/quantumCrypto');
const { analyzeSentiment, triggerInstantEscalation } = require('../services/sentimentEscalationEngine');
const {
  lookupOrderTool,
  cancelOrderTool,
  initiateReturnTool,
  checkRefundStatusTool,
  queryInventoryCatalogTool,
  lookupAccountWalletLoyaltyTool,
  lookupCouponsAndOffersTool,
  lookupWarrantyAndSerialTool,
} = require('../services/aiSupportTools');
const {
  buildContextualGreeting,
  detectIntentAndToolPlan,
  processSupportTurn,
  synthesizeDeterministicResponse,
} = require('../services/aiSupportOrchestrator');
const supportRoutes = require('../routes/supportRoutes');

const TEST_JWT_SECRET = 'ai-support-live-test-secret-with-more-than-32-chars';
process.env.JWT_SECRET = TEST_JWT_SECRET;

/**
 * In-memory MySQL Pool Mock for deterministic end-to-end verification of
 * AI Support Sessions, Messages, Escalations, Orders, Returns, Refunds, Inventory,
 * Wallets, Loyalty, Coupons, Warranties, Multi-Role Agents, and SuperAdmin Support Command.
 */
function createMockSupportPool(agentPasswordHash = '') {
  const state = {
    sessions: [],
    messages: [],
    escalations: [],
    tickets: [],
    ticketMessages: [],
    notifications: [],
    featureConfigJson: null,
    supportAgents: [
      {
        id: 1,
        username: 'concierge_lead',
        name: 'Priya Nair',
        email: 'priya@bhumivera.com',
        role: 'manager',
        department: 'Executive Support',
        permissions: null,
        max_concurrent_chats: 25,
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
        loyalty_lifetime_points: 1200,
        referral_code: 'BV-AARAV7',
        created_at: new Date(Date.now() - 60 * 86400 * 1000).toISOString(),
      },
      {
        id: 1,
        name: 'Super Admin',
        email: 'admin@bhumivera.com',
        phone: '9000000001',
        role: 'superadmin',
        is_active: 1,
        wallet_balance: 0,
        loyalty_points: 0,
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
    coupons: [
      {
        id: 1,
        code: 'BOTANICAL15',
        discount_type: 'percentage',
        discount_value: 15,
        min_order_amount: 499,
        max_discount: 300,
        reward_type: 'standard',
        expires_at: new Date(Date.now() + 30 * 86400 * 1000).toISOString(),
        is_active: 1,
        restricted_user_id: null,
      },
    ],
    serials: [
      {
        id: 1,
        serial_number: 'BV-SER-2026-8899',
        status: 'registered',
        is_registered: 1,
        product_id: 11,
        product_name: 'Kumkumadi Night Elixir',
        sku: 'BV-KUM-30',
        warranty_period: '12 Months',
      },
    ],
    warranties: [
      {
        id: 1,
        user_id: 7,
        product_id: 11,
        serial_number: 'BV-SER-2026-8899',
        purchase_date: new Date(Date.now() - 10 * 86400 * 1000).toISOString(),
        expiry_date: new Date(Date.now() + 355 * 86400 * 1000).toISOString(),
        status: 'active',
        product_name: 'Kumkumadi Night Elixir',
        sku: 'BV-KUM-30',
        warranty_period: '12 Months',
      },
    ],
  };

  const executeQuery = async (sql, params = []) => {
    const norm = sql.replace(/\s+/g, ' ').trim();

    if (norm.startsWith('CREATE TABLE IF NOT EXISTS') || norm.startsWith('ALTER TABLE')) {
      return [{ affectedRows: 0 }];
    }
    if (norm.includes("FROM settings WHERE group_name = 'ai_support_features'")) {
      return [state.featureSettings || []];
    }
    if (norm.startsWith("INSERT INTO settings (key_name, value, group_name)")) {
      state.featureSettings = state.featureSettings || [];
      const key = norm.includes("support_canned_macros") ? "support_canned_macros" : params[0];
      const val = norm.includes("support_canned_macros") ? params[0] : params[1];
      const existing = state.featureSettings.find(r => r.key_name === key);
      if (existing) existing.value = val;
      else state.featureSettings.push({ key_name: key, value: val });
      return [{ affectedRows: 1 }];
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
    if (norm.includes('FROM users WHERE LOWER(email) = ?')) {
      const u = state.users.find(x => x.email.toLowerCase() === String(params[0]).toLowerCase());
      return [u ? [u] : []];
    }
    if (norm.startsWith('UPDATE users SET wallet_balance = COALESCE(wallet_balance, 0) + ? WHERE id = ?')) {
      const u = state.users.find(x => x.id === Number(params[1]));
      if (u) u.wallet_balance += Number(params[0]);
      return [{ affectedRows: u ? 1 : 0 }];
    }
    if (norm.includes('FROM user_sessions') || norm.includes('FROM admin_sessions')) {
      return [[{ jti: 'active-jti' }]];
    }

    // Wallet & Loyalty & Coupons & Warranties
    if (norm.includes('FROM wallets WHERE user_id = ?')) {
      const u = state.users.find(x => x.id === Number(params[0]));
      return [u ? [{ balance: u.wallet_balance }] : []];
    }
    if (norm.includes('FROM referral_wallets WHERE user_id = ?')) {
      return [[{ balance: 150 }]];
    }
    if (norm.includes('FROM referral_codes WHERE user_id = ?')) {
      return [[{ code: 'BV-AARAV7' }]];
    }
    if (norm.includes('FROM loyalty_tiers')) {
      return [[
        { name: 'Seedling', min_points: 0, points_multiplier: 1, tier_discount_percent: 0, cashback_percent: 0, free_shipping: 0 },
        { name: 'Botanist', min_points: 300, points_multiplier: 1.25, tier_discount_percent: 5, cashback_percent: 2, free_shipping: 1 },
        { name: 'Emerald Sovereign', min_points: 1000, points_multiplier: 1.5, tier_discount_percent: 12, cashback_percent: 5, free_shipping: 1 },
      ]];
    }
    if (norm.includes('FROM coupons')) {
      return [state.coupons];
    }
    if (norm.includes('FROM product_serials ps')) {
      const found = state.serials.filter(s => s.serial_number.toUpperCase() === String(params[0]).toUpperCase());
      return [found];
    }
    if (norm.includes('FROM warranties')) {
      return [state.warranties];
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
    if (norm.includes('FROM support_agents ORDER BY')) {
      return [state.supportAgents];
    }
    if (norm.startsWith('INSERT INTO support_agents')) {
      const newAg = {
        id: state.supportAgents.length + 1,
        username: params[0],
        name: params[1],
        email: params[2],
        password_hash: params[3],
        role: params[4] || 'agent',
        department: params[5] || 'General Concierge',
        permissions: params[6] || null,
        max_concurrent_chats: params[7] || 10,
        is_active: 1,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };
      state.supportAgents.push(newAg);
      return [{ insertId: newAg.id }];
    }
    if (norm.startsWith('UPDATE support_agents SET')) {
      const id = Number(params[params.length - 1]);
      const ag = state.supportAgents.find(a => a.id === id);
      if (ag) {
        if (norm.includes('last_login_at = NOW()')) {
          ag.online_status = 'online';
        } else if (norm.includes('SET is_active = ? WHERE id = ?')) {
          ag.is_active = Number(params[0]);
        } else {
          ag.name = params[0];
          ag.email = params[1];
          ag.role = params[2];
          ag.department = params[3];
          ag.permissions = params[4];
          ag.max_concurrent_chats = params[5];
          ag.is_active = params[6];
        }
      }
      return [{ affectedRows: ag ? 1 : 0 }];
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
    if (norm.includes('FROM ai_support_sessions s') && norm.includes('ORDER BY')) {
      return [state.sessions.map(s => ({
        ...s,
        customer_name: state.users.find(u => u.id === s.user_id)?.name || s.guest_name,
        customer_email: state.users.find(u => u.id === s.user_id)?.email || s.guest_email,
        message_count: state.messages.filter(m => m.session_id === s.id).length,
        last_message_preview: state.messages.filter(m => m.session_id === s.id).slice(-1)[0]?.content || '',
      }))];
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
      const lastParam = params[params.length - 1];
      const found = state.sessions.find(s => s.id === Number(lastParam) || s.session_token === String(lastParam));
      if (found) {
        if (norm.includes('SET sentiment_score')) {
          if (params[0] !== null) found.sentiment_score = params[0];
          if (params[1] !== null) found.frustration_score = params[1];
          if (params[2] !== null) found.priority = params[2];
          if (params[3] !== null) found.status = params[3];
          if (params[4] !== null) found.escalated_ticket_id = params[4];
          if (params[5] !== null) found.assigned_agent_id = params[5];
          if (params[6] !== null) found.assigned_agent_name = params[6];
          if (params[7] !== null) found.assigned_role = params[7];
          if (params[8] !== null) found.resolution_note = params[8];
          if (params[9] !== null) found.csat_rating = params[9];
          if (params[10] !== null) found.csat_feedback = params[10];
          if (params[11] !== null) found.closed_by = params[11];
        } else {
          found.page_context = params[params.length - 2];
        }
      }
      return [{ affectedRows: found ? 1 : 0 }];
    }

    // ai_support_messages (10 columns: session_id, sender, sender_name, is_internal_note, content, tool_calls, order_cards, quick_actions, attachments, sentiment)
    if (norm.startsWith('INSERT INTO ai_support_messages')) {
      const msg = {
        id: state.messages.length + 1,
        session_id: params[0],
        sender: params[1],
        sender_name: params[2],
        is_internal_note: params[3],
        content: params[4],
        tool_calls: params[5],
        order_cards: params[6],
        quick_actions: params[7],
        attachments: params[8],
        sentiment: params[9],
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
      if (norm.includes('OR o.tracking_number LIKE ?')) {
        const matches = state.orders.filter(
          o =>
            o.order_number === ref ||
            o.id === num ||
            (o.tracking_number && o.tracking_number.includes(ref)) ||
            (o.user_email && o.user_email.toLowerCase().includes(ref.toLowerCase())) ||
            (o.user_phone && o.user_phone.includes(ref))
        );
        return [matches.map(o => ({ ...o, customer_name: o.user_name, customer_email: o.user_email, customer_phone: o.user_phone }))];
      }
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

    // ai_support_benefit_ledger
    if (norm.startsWith('INSERT INTO ai_support_benefit_ledger')) {
      state.benefitLedger = state.benefitLedger || [];
      const row = {
        id: state.benefitLedger.length + 1,
        session_id: params[0],
        user_id: params[1],
        customer_identifier: params[2],
        order_id: params[3],
        staff_id: params[4],
        staff_name: params[5],
        staff_role: params[6],
        benefit_type: norm.includes("'coupon'") ? 'coupon' : 'wallet_credit',
        amount_or_percent: params[7],
        coupon_code: norm.includes("'coupon'") ? params[8] : null,
        signature_sha512: norm.includes("'coupon'") ? params[9] : params[8],
        created_at: new Date().toISOString(),
      };
      state.benefitLedger.push(row);
      return [{ insertId: row.id }];
    }
    if (norm.includes('FROM ai_support_benefit_ledger')) {
      state.benefitLedger = state.benefitLedger || [];
      const bType = norm.includes("benefit_type = 'coupon'") ? 'coupon' : 'wallet_credit';
      const sessId = Number(params[0]);
      const uId = Number(params[1]);
      const found = state.benefitLedger.filter(
        b => b.benefit_type === bType && (Number(b.session_id) === sessId || (uId > 0 && Number(b.user_id) === uId))
      );
      return [found];
    }

    // Universal search orders & checkCustomerHasPlacedOrder
    if (norm.includes('FROM orders') && norm.includes('WHERE user_id = ?') && norm.includes("status NOT IN ('cancelled', 'failed')")) {
      const matches = state.orders.filter(o => Number(o.user_id) === Number(params[0]) && o.status !== 'cancelled');
      return [matches];
    }
    if (norm.includes('FROM orders o') && norm.includes('OR o.tracking_number LIKE ?')) {
      const ref = String(params[0]);
      const matches = state.orders.filter(
        o =>
          o.order_number === ref ||
          o.id === Number(params[1]) ||
          (o.tracking_number && o.tracking_number.includes(ref)) ||
          (o.user_email && o.user_email.toLowerCase().includes(ref.toLowerCase())) ||
          (o.user_phone && o.user_phone.includes(ref))
      );
      return [matches.map(o => ({ ...o, customer_name: o.user_name, customer_email: o.user_email, customer_phone: o.user_phone }))];
    }

    // DELETE session queries
    if (norm.startsWith('DELETE FROM ai_support_messages WHERE session_id = ?')) {
      state.messages = state.messages.filter(m => Number(m.session_id) !== Number(params[0]));
      return [{ affectedRows: 1 }];
    }
    if (norm.startsWith('DELETE FROM ai_support_escalations WHERE session_id = ?')) {
      state.escalations = state.escalations.filter(e => Number(e.session_id) !== Number(params[0]));
      return [{ affectedRows: 1 }];
    }
    if (norm.startsWith('DELETE FROM ai_support_sessions WHERE id = ?')) {
      state.sessions = state.sessions.filter(s => Number(s.id) !== Number(params[0]));
      return [{ affectedRows: 1 }];
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

describe('Phase 4 & 20X Verification Suite: Autonomous Enterprise AI Customer Support Engine', () => {
  let mockPool;

  before(async () => {
    const hash = await bcrypt.hash('SupportPass!2026', 8);
    mockPool = createMockSupportPool(hash);
  });

  it('greets customers by name once with a short, natural opening', () => {
    const { greeting } = buildContextualGreeting({
      user: { name: 'Aarav Sharma' },
      pageContext: { pathname: '/' },
    });

    assert.equal(greeting, 'Hi Aarav, how can I help you today?');
    assert.doesNotMatch(greeting, /Namaste|20X|AI|bot/i);
  });

  it('confirms support escalation in plain language without internal workflow terms', () => {
    const { reply } = synthesizeDeterministicResponse({
      userMessage: 'Please connect me with a human support agent.',
      escalation: {
        escalated: true,
        ticketId: 8,
        slaResponseWindow: 'Under 30 minutes',
      },
    });

    assert.match(reply, /support specialist/i);
    assert.match(reply, /ticket #8/i);
    assert.match(reply, /within 30 minutes/i);
    assert.doesNotMatch(reply, /AI|priority tier|channels alerted|Senior Concierge/i);
  });

  it('1. PII Masker redacts payment cards, CVVs, passwords, OTPs, and JWTs while preserving 9-digit Order IDs', () => {
    const raw =
      'My order is #918273645 and phone is 9876543210. My card 4532 0151 1283 0366 CVV: 842 password is SuperSecret99! OTP is 482910 and Bearer eyJhbGciOiJIUzI1NiJ9.eyJ1c2VyIjo3fQ.sig12345678';
    const masked = maskPII(raw);

    assert.match(masked, /918273645/, 'Should preserve 9-digit Bhumivera order number');
    assert.match(masked, /9876543210/, 'Should preserve 10-digit customer phone number');
    assert.doesNotMatch(masked, /4532 0151 1283 0366/, 'Should redact 16-digit payment card');
    assert.match(masked, /\[REDACTED_CARD_ENDING_0366\]/);
    assert.doesNotMatch(masked, /842/, 'Should redact CVV');
    assert.match(masked, /\[REDACTED_CVV\]/);
    assert.doesNotMatch(masked, /SuperSecret99!/, 'Should redact password');
    assert.match(masked, /\[REDACTED_SECRET\]/);
    assert.doesNotMatch(masked, /482910/, 'Should redact OTP');
    assert.match(masked, /\[REDACTED_OTP\]/);
    assert.match(masked, /\[REDACTED_TOKEN\]/);

    const sanitizedObj = sanitizeObjectPII({
      orderId: '918273645',
      password: 'plain_password',
      nested: { cvv: '999', note: 'Card 4111-1111-1111-1111' },
    });
    assert.equal(sanitizedObj.password, '[REDACTED]');
    assert.equal(sanitizedObj.nested.cvv, '[REDACTED]');
    assert.match(sanitizedObj.nested.note, /\[REDACTED_CARD_ENDING_1111\]/);
  });

  it('2. Sentiment & Escalation Engine scores frustration, priority tiers, and dispatches multi-channel webhooks', async () => {
    const calm = analyzeSentiment('Thank you so much, my Kumkumadi oil arrived and I love it!');
    assert.equal(calm.priority, 'Low');
    assert.equal(calm.shouldEscalate, false);
    assert.ok(calm.score > 0);

    const frustrated = analyzeSentiment(
      'WORST SERVICE!! My bottle is leaking and payment deducted twice!! Give my money back immediately or I go to consumer court!!!',
      [{ sender: 'user', sentiment: { score: -0.5, frustrationScore: 60 } }],
      { rageClickDetected: true }
    );
    assert.equal(frustrated.priority, 'Critical');
    assert.equal(frustrated.shouldEscalate, true);
    assert.ok(frustrated.frustrationScore >= 80);

    const webhookCalls = [];
    const mailCalls = [];
    process.env.SUPPORT_TELEGRAM_WEBHOOK_URL = 'https://api.telegram.org/botTEST/sendMessage';
    process.env.SUPPORT_WHATSAPP_WEBHOOK_URL = 'https://graph.facebook.com/v19.0/test/messages';

    const escResult = await triggerInstantEscalation({
      pool: mockPool,
      session: { id: 1, userId: 7, guestName: 'Aarav Sharma', guestEmail: 'aarav@example.com' },
      user: { id: 7, name: 'Aarav Sharma', email: 'aarav@example.com', phone: '9876543210' },
      latestMessage: 'Payment deducted twice, connect me to a human manager!',
      sentiment: frustrated,
      orderId: 101,
      transcript: [{ sender: 'user', content: 'Payment deducted twice!' }],
      sendMailFn: async payload => {
        mailCalls.push(payload);
        return { ok: true };
      },
      httpPostFn: async (url, body) => {
        webhookCalls.push({ url, body });
        return { ok: true, status: 200 };
      },
    });

    assert.equal(escResult.escalated, true);
    assert.equal(escResult.priority, 'Critical');
    assert.ok(escResult.ticketId >= 501, 'Should create human support ticket in support_tickets');
    assert.equal(webhookCalls.length, 2, 'Should fire Telegram and WhatsApp webhooks');
    assert.equal(mailCalls.length, 1, 'Should send Admin escalation email');

    delete process.env.SUPPORT_TELEGRAM_WEBHOOK_URL;
    delete process.env.SUPPORT_WHATSAPP_WEBHOOK_URL;
  });

  it('3. Autonomous Tool Engine: lookup_order enforces ownership authorization and returns rich order cards', async () => {
    const unauth = await lookupOrderTool(
      { order_id: '918273645' },
      { pool: mockPool, user: null, session: {} }
    );
    assert.equal(unauth.success, false);
    assert.equal(unauth.code, 'VERIFICATION_REQUIRED');

    const guestAuth = await lookupOrderTool(
      { order_id: '918273645', phone: '+91 98765-43210' },
      { pool: mockPool, user: null, session: {} }
    );
    assert.equal(guestAuth.success, true);
    assert.equal(guestAuth.code, 'ORDER_FOUND');
    assert.equal(guestAuth.order.orderNumber, '918273645');
    assert.equal(guestAuth.order.cancellable, true);
  });

  it('4. Autonomous Tool Engine: cancel_order cancels COD orders & restocks inventory, and safeguards paid online orders', async () => {
    const initialStock = mockPool.state.products[0].quantity;

    const cancelCod = await cancelOrderTool(
      { order_id: '918273645', reason: 'Ordered wrong address' },
      { pool: mockPool, user: { id: 7, name: 'Aarav Sharma', email: 'aarav@example.com' } }
    );
    assert.equal(cancelCod.success, true);
    assert.equal(cancelCod.code, 'ORDER_CANCELLED');
    assert.equal(mockPool.state.orders[0].status, 'cancelled');
    assert.equal(mockPool.state.products[0].quantity, initialStock + 1, 'Should restock product quantity');

    const cancelOnline = await cancelOrderTool(
      { order_id: '918273647', reason: 'Need to change payment method' },
      { pool: mockPool, user: { id: 7, name: 'Aarav Sharma', email: 'aarav@example.com' } }
    );
    assert.equal(cancelOnline.success, true);
    assert.equal(cancelOnline.code, 'ONLINE_REFUND_CANCELLATION_QUEUED');
    assert.ok(cancelOnline.ticketId >= 501);
  });

  it('5. Autonomous Tool Engine: initiate_return, check_refund_status, and query_inventory_catalog work end-to-end', async () => {
    const ret = await initiateReturnTool(
      {
        order_id: '918273646',
        reason: 'Received leaking jar',
        resolution_type: 'refund',
        refund_method: 'original',
      },
      { pool: mockPool, user: { id: 7, name: 'Aarav Sharma', email: 'aarav@example.com' } }
    );
    assert.equal(ret.success, true);
    assert.equal(ret.code, 'RETURN_INITIATED');
    assert.match(ret.rmaNumber, /^RMA-[A-F0-9]{8}$/);

    const refundCheck = await checkRefundStatusTool(
      { rma_number: ret.rmaNumber },
      { pool: mockPool, user: { id: 7, name: 'Aarav Sharma', email: 'aarav@example.com' } }
    );
    assert.equal(refundCheck.success, true);
    assert.equal(refundCheck.code, 'REFUND_STATUS_FOUND');
    assert.equal(refundCheck.latestRefund.rmaNumber, ret.rmaNumber);

    const cat = await queryInventoryCatalogTool(
      { query: 'Kumkumadi' },
      { pool: mockPool }
    );
    assert.equal(cat.success, true);
    assert.equal(cat.products.length, 1);
    assert.equal(cat.products[0].sku, 'BV-KUM-30');
  });

  it('6. 20X Deep Tools: lookup_account_wallet_loyalty, lookup_coupons_and_offers, and lookup_warranty_and_serial fetch 100% accurate details', async () => {
    const walletRes = await lookupAccountWalletLoyaltyTool(
      {},
      { pool: mockPool, user: { id: 7, name: 'Aarav Sharma', email: 'aarav@example.com' } }
    );
    assert.equal(walletRes.success, true);
    assert.equal(walletRes.code, 'ACCOUNT_WALLET_LOYALTY_FOUND');
    assert.equal(walletRes.accountSummary.spendableWalletBalanceInr, 250);
    assert.equal(walletRes.accountSummary.referralWalletBalanceInr, 150);
    assert.equal(walletRes.accountSummary.loyaltyPointsAvailable, 400);
    assert.equal(walletRes.accountSummary.loyaltyTier.name, 'Emerald Sovereign');

    const couponRes = await lookupCouponsAndOffersTool(
      {},
      { pool: mockPool, user: { id: 7, email: 'aarav@example.com' } }
    );
    assert.equal(couponRes.success, true);
    assert.equal(couponRes.code, 'COUPONS_FOUND');
    assert.ok(couponRes.coupons.some(c => c.code === 'BOTANICAL15'));

    const warrantyRes = await lookupWarrantyAndSerialTool(
      { serial_number: 'BV-SER-2026-8899' },
      { pool: mockPool, user: { id: 7, email: 'aarav@example.com' } }
    );
    assert.equal(warrantyRes.success, true);
    assert.equal(warrantyRes.code, 'SERIAL_VERIFIED');
    assert.equal(warrantyRes.serialInfo.serialNumber, 'BV-SER-2026-8899');
  });

  it('7. Orchestrator: processSupportTurn persists masked multi-turn memory and handles LLM fallback gracefully', async () => {
    const turn1 = await processSupportTurn({
      message: 'Where is my order #918273646? Also my secret password is MyPass123!',
      user: { id: 7, name: 'Aarav Sharma', email: 'aarav@example.com', phone: '9876543210' },
      pageContext: { pathname: '/order-tracking' },
      pool: mockPool,
    });

    assert.ok(turn1.sessionToken);
    assert.equal(turn1.orderCards.length, 1);
    assert.equal(turn1.orderCards[0].orderNumber, '918273646');

    const storedUserMsg = mockPool.state.messages.find(
      m => m.session_id === turn1.sessionId && m.sender === 'user'
    );
    assert.doesNotMatch(storedUserMsg.content, /MyPass123!/);
    assert.match(storedUserMsg.content, /\[REDACTED_SECRET\]/);
  });
});

describe('Live HTTP Server, SSE Streaming & 20X SuperAdmin Support Verification (/api/support/*)', () => {
  let server;
  let baseUrl;
  let mockPool;
  let origPoolQuery;
  let origPoolExecute;
  let origPoolGetConnection;
  let customerToken;
  let superAdminToken;

  before(async () => {
    const hash = await bcrypt.hash('SupportPass!2026', 8);
    mockPool = createMockSupportPool(hash);

    origPoolQuery = pool.query;
    origPoolExecute = pool.execute;
    origPoolGetConnection = pool.getConnection;
    pool.query = mockPool.query;
    pool.execute = mockPool.execute;
    pool.getConnection = mockPool.getConnection;

    customerToken = jwt.sign(
      { id: 7, name: 'Aarav Sharma', email: 'aarav@example.com', role: 'customer', sessionType: 'user' },
      TEST_JWT_SECRET,
      { expiresIn: '1h', jwtid: 'active-jti' }
    );

    superAdminToken = jwt.sign(
      { id: 1, name: 'Super Admin', email: 'admin@bhumivera.com', role: 'superadmin', sessionType: 'admin' },
      TEST_JWT_SECRET,
      { expiresIn: '1h', jwtid: 'active-jti' }
    );

    const app = express();
    app.use(express.json());
    app.use('/api/support', supportRoutes);

    await new Promise(resolve => {
      server = app.listen(0, '127.0.0.1', () => {
        const { port } = server.address();
        baseUrl = `http://127.0.0.1:${port}/api/support`;
        resolve();
      });
    });
  });

  after(async () => {
    pool.query = origPoolQuery;
    pool.execute = origPoolExecute;
    pool.getConnection = origPoolGetConnection;
    if (server) {
      await new Promise(resolve => server.close(resolve));
    }
  });

  it('8. Live HTTP POST /chat/session and POST /chat/context initialize session and return contextual nudges', async () => {
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
    assert.match(sessionData.greeting, /2:00 PM IST/);
  });

  it('9. Live HTTP POST /chat/message & GET /chat/history/:token execute order lookup and enforce session ownership', async () => {
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

  it('10. Live HTTP POST /chat/stream streams real-time Server-Sent Events (status, tool_call, token, metadata, done)', async () => {
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

  it('11. Live HTTP 20X Chat Lifecycle Controls: Blocks Customer Status Manipulation (403) & Enforces Support-Only Status Control', async () => {
    const newChatRes = await fetch(`${baseUrl}/chat/session`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${customerToken}`,
      },
      body: JSON.stringify({ forceNew: true, pageContext: { pathname: '/profile' } }),
    });
    assert.equal(newChatRes.status, 200);
    const newChat = await newChatRes.json();
    const token = newChat.sessionToken;

    // Customer attempting to mark resolved/pending is blocked with 403 STATUS_CONTROLLED_BY_SUPPORT
    const customerStatusAttempt = await fetch(`${baseUrl}/chat/session/${token}/status`, {
      method: 'PATCH',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${customerToken}`,
      },
      body: JSON.stringify({ status: 'resolved' }),
    });
    assert.equal(customerStatusAttempt.status, 403);
    const forbiddenData = await customerStatusAttempt.json();
    assert.equal(forbiddenData.code, 'STATUS_CONTROLLED_BY_SUPPORT');

    // Support Executive / SuperAdmin transitions chat through all statuses
    for (const status of ['pending', 'waiting_for_review', 'resolved', 'closed', 'active']) {
      const statusRes = await fetch(`${baseUrl}/sessions/${token}/status`, {
        method: 'PATCH',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${superAdminToken}`,
        },
        body: JSON.stringify({ status }),
      });
      assert.equal(statusRes.status, 200);
      const statusData = await statusRes.json();
      assert.equal(statusData.success, true);
      assert.equal(statusData.session.status, status);
    }

    const ratingRes = await fetch(`${baseUrl}/chat/session/${token}/rating`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${customerToken}`,
      },
      body: JSON.stringify({ rating: 5, feedback: 'Super fast resolution, better than Amazon!' }),
    });
    assert.equal(ratingRes.status, 200);
    const ratingData = await ratingRes.json();
    assert.equal(ratingData.success, true);
    assert.equal(ratingData.rating, 5);

    const endChatRes = await fetch(`${baseUrl}/chat/session/${token}/end-satisfied`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${TEST_JWT_SECRET}`,
      },
      body: JSON.stringify({}),
    });
    assert.equal(endChatRes.status, 200);
    const endChatData = await endChatRes.json();
    assert.equal(endChatData.status, 'resolved');
    assert.equal(endChatData.rating, null);
  });

  it('12. Live HTTP 20X Multi-Role Agent RBAC (Agent / Supervisor / Manager), Barge-In, Whisper Notes & Goodwill Credits', async () => {
    const createAgentRes = await fetch(`${baseUrl}/agents`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${superAdminToken}`,
      },
      body: JSON.stringify({
        username: 'agent.rohan',
        name: 'Rohan Verma',
        email: 'rohan@bhumivera.com',
        role: 'agent',
        department: 'L1 Order Desk',
        password: 'AgentPassword123!',
      }),
    });
    assert.equal(createAgentRes.status, 201);
    const createdAgent = (await createAgentRes.json()).agent;
    assert.equal(createdAgent.role, 'agent');
    assert.equal(createdAgent.permissions.can_reply_chats, true);
    assert.equal(createdAgent.permissions.can_adjust_wallet_goodwill, false);

    // Promote Rohan to Supervisor via PATCH /agents/:id
    const promoteRes = await fetch(`${baseUrl}/agents/${createdAgent.id}`, {
      method: 'PATCH',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${superAdminToken}`,
      },
      body: JSON.stringify({ role: 'supervisor' }),
    });
    assert.equal(promoteRes.status, 200);
    const promotedAgent = (await promoteRes.json()).agent;
    assert.equal(promotedAgent.role, 'supervisor');
    assert.equal(promotedAgent.permissions.can_adjust_wallet_goodwill, true);

    // Log in as Manager (concierge_lead)
    const loginRes = await fetch(`${baseUrl}/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'concierge_lead', password: 'SupportPass!2026' }),
    });
    assert.equal(loginRes.status, 200);
    const managerToken = (await loginRes.json()).token;

    // List live sessions via GET /sessions
    const sessionsRes = await fetch(`${baseUrl}/sessions`, {
      headers: { authorization: `Bearer ${managerToken}` },
    });
    assert.equal(sessionsRes.status, 200);
    const sessionsData = await sessionsRes.json();
    assert.ok(sessionsData.sessions.length >= 1);
    const targetSessionToken = sessionsData.sessions[0].sessionToken;

    // Post an internal Whisper Note
    const whisperRes = await fetch(`${baseUrl}/sessions/${targetSessionToken}/reply`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${managerToken}`,
      },
      body: JSON.stringify({
        message: 'Internal coaching note: offer ₹100 wallet credit if customer asks.',
        isInternalNote: true,
      }),
    });
    assert.equal(whisperRes.status, 201);

    // Issue 1-click Goodwill Wallet Credit via POST /sessions/:sessionToken/execute-action
    const creditRes = await fetch(`${baseUrl}/sessions/${targetSessionToken}/execute-action`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${managerToken}`,
      },
      body: JSON.stringify({
        action: 'goodwill_wallet_credit',
        goodwillAmount: 150,
      }),
    });
    assert.equal(creditRes.status, 200);
    const creditData = await creditRes.json();
    assert.equal(creditData.success, true);
    assert.equal(creditData.amount, 150);
  });

  it('13. Live HTTP 20X SuperAdmin Support Command Center (/superadmin/overview & /superadmin/features)', async () => {
    const overviewRes = await fetch(`${baseUrl}/superadmin/overview`, {
      headers: { authorization: `Bearer ${superAdminToken}` },
    });
    assert.equal(overviewRes.status, 200);
    const overviewData = await overviewRes.json();
    assert.equal(overviewData.success, true);
    assert.ok(overviewData.metrics);
    assert.ok(overviewData.agents);
    assert.ok(overviewData.featureConfig);

    const updateFeatRes = await fetch(`${baseUrl}/superadmin/features`, {
      method: 'PUT',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${superAdminToken}`,
      },
      body: JSON.stringify({
        support_frustration_threshold: 65,
        ai_proactive_linger_seconds: 30,
      }),
    });
    assert.equal(updateFeatRes.status, 200);
    const featData = await updateFeatRes.json();
    assert.equal(featData.success, true);
    assert.equal(featData.featureConfig.support_frustration_threshold, 65);
    assert.equal(featData.featureConfig.ai_proactive_linger_seconds, 30);
  });

  it('14. 512-Bit Quantum Cryptographic Envelope & Hash Chain (utils/quantumCrypto.js) verifies integrity and detects tampering', () => {
    const sig = computeQuantumHash512({ action: 'COUPON', pct: 15 }, 'GENESIS_512');
    assert.equal(sig.length, 128, 'Should produce a 512-bit (128 hex char) SHA-512 HMAC digest');
    assert.equal(verifyQuantumSignature({ action: 'COUPON', pct: 15 }, sig, 'GENESIS_512'), true);
    assert.equal(verifyQuantumSignature({ action: 'COUPON', pct: 30 }, sig, 'GENESIS_512'), false, 'Tampered payload must fail verification');

    const encrypted = encryptQuantumPayload('8304879119:AAGEC1XbwxJhxdNv0JPaknsnMHk9xeops9g');
    assert.match(encrypted, /^q512:/);
    const decrypted = decryptQuantumPayload(encrypted);
    assert.equal(decrypted, '8304879119:AAGEC1XbwxJhxdNv0JPaknsnMHk9xeops9g');
  });

  it('15. Live HTTP 30X Universal Search (/universal-search) finds orders by Order ID, Tracking ID, Email, and Phone with Customer Verification Checklist', async () => {
    const searchRes = await fetch(`${baseUrl}/universal-search?q=DLV99881122`, {
      headers: { authorization: `Bearer ${superAdminToken}` },
    });
    assert.equal(searchRes.status, 200);
    const searchData = await searchRes.json();
    assert.equal(searchData.success, true);
    assert.equal(searchData.orders.length, 1);
    assert.equal(searchData.orders[0].orderNumber, '918273646');
    assert.equal(searchData.orders[0].trackingNumber, 'DLV99881122');
    assert.equal(searchData.orders[0].verificationChecklist.registeredEmail, 'aarav@example.com');
    assert.ok(searchData.orders[0].items.length >= 1);
  });

  it('16. Live HTTP 30X Anti-Fraud Guardrails: Staff 1-Time Coupon Limit, Role Discount Caps, SuperAdmin Unlimited Coupons & SuperAdmin-Only Delete Resolved Chat', async () => {
    // Log in as Manager (concierge_lead)
    const loginRes = await fetch(`${baseUrl}/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'concierge_lead', password: 'SupportPass!2026' }),
    });
    const managerToken = (await loginRes.json()).token;

    // Create a fresh session for customer
    const sessRes = await fetch(`${baseUrl}/chat/session`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${customerToken}` },
      body: JSON.stringify({ forceNew: true }),
    });
    const sessionToken = (await sessRes.json()).sessionToken;

    // 1. Manager tries to issue a 30% coupon (above Manager 15% benchmark) -> 403 BLOCKED
    const excessiveCouponRes = await fetch(`${baseUrl}/sessions/${sessionToken}/execute-action`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${managerToken}` },
      body: JSON.stringify({ action: 'issue_apology_coupon', discountPercent: 30 }),
    });
    assert.equal(excessiveCouponRes.status, 403);
    assert.equal((await excessiveCouponRes.json()).code, 'COUPON_DISCOUNT_EXCEEDS_ROLE_BENCHMARK');

    // 2. Manager issues a valid 15% coupon ONCE -> 200 OK
    const firstCouponRes = await fetch(`${baseUrl}/sessions/${sessionToken}/execute-action`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${managerToken}` },
      body: JSON.stringify({ action: 'issue_apology_coupon', discountPercent: 15 }),
    });
    assert.equal(firstCouponRes.status, 200);
    const firstCouponData = await firstCouponRes.json();
    assert.equal(firstCouponData.success, true);
    assert.equal(firstCouponData.signature512.length, 128);

    // 3. Manager tries to issue a SECOND coupon to the same customer -> 403 COUPON_ONCE_ONLY_FOR_STAFF
    const secondCouponRes = await fetch(`${baseUrl}/sessions/${sessionToken}/execute-action`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${managerToken}` },
      body: JSON.stringify({ action: 'issue_apology_coupon', discountPercent: 10 }),
    });
    assert.equal(secondCouponRes.status, 403);
    assert.equal((await secondCouponRes.json()).code, 'COUPON_ONCE_ONLY_FOR_STAFF');

    // 4. SuperAdmin CAN issue additional coupons multiple times -> 200 OK
    const superCouponRes = await fetch(`${baseUrl}/sessions/${sessionToken}/execute-action`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${superAdminToken}` },
      body: JSON.stringify({ action: 'issue_apology_coupon', discountPercent: 25 }),
    });
    assert.equal(superCouponRes.status, 200);

    // 5. Customer ends chat as Satisfied with a 5-star review -> status becomes resolved
    const endSatRes = await fetch(`${baseUrl}/chat/session/${sessionToken}/end-satisfied`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${customerToken}` },
      body: JSON.stringify({ rating: 5, feedback: 'Solved my issue and gave a courtesy coupon!' }),
    });
    assert.equal(endSatRes.status, 200);

    // 6. Manager tries to delete the resolved chat -> 403 SUPERADMIN_ONLY_DELETE
    const mgrDeleteRes = await fetch(`${baseUrl}/sessions/${sessionToken}`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${managerToken}` },
    });
    assert.equal(mgrDeleteRes.status, 403);
    assert.equal((await mgrDeleteRes.json()).code, 'SUPERADMIN_ONLY_DELETE');

    // 7. SuperAdmin deletes the resolved chat -> 200 OK
    const superDeleteRes = await fetch(`${baseUrl}/sessions/${sessionToken}`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${superAdminToken}` },
    });
    assert.equal(superDeleteRes.status, 200);
    assert.equal((await superDeleteRes.json()).deleted, true);
  });

  it('17. Live HTTP 30X Order-Gated Live Agent Rule, Async Message Channel & Two-Way Telegram Webhook (@BhumiveraBot)', async () => {
    // Visitor without any placed order (user id 888) tries to escalate to a live human agent -> 403 ORDER_REQUIRED_FOR_LIVE_AGENT
    const noOrderUserToken = jwt.sign(
      { id: 888, name: 'New Visitor', email: 'visitor@example.com', role: 'customer', sessionType: 'user' },
      TEST_JWT_SECRET,
      { expiresIn: '1h', jwtid: 'active-jti' }
    );
    const escBlockedRes = await fetch(`${baseUrl}/chat/escalate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${noOrderUserToken}` },
      body: JSON.stringify({ reason: 'Want to talk to agent', message: 'Connect me to an agent' }),
    });
    assert.equal(escBlockedRes.status, 403);
    const escBlockedData = await escBlockedRes.json();
    assert.equal(escBlockedData.code, 'ORDER_REQUIRED_FOR_LIVE_AGENT');
    assert.equal(escBlockedData.showAsyncMessageForm, true);

    // Visitor submits an Async Message instead -> 201 Created
    const asyncRes = await fetch(`${baseUrl}/chat/async-message`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${noOrderUserToken}` },
      body: JSON.stringify({
        subject: 'Pre-order question about Kumkumadi oil',
        message: 'Is this suitable for sensitive skin?',
      }),
    });
    assert.equal(asyncRes.status, 201);
    const asyncData = await asyncRes.json();
    assert.equal(asyncData.success, true);
    assert.ok(asyncData.sessionToken);

    // Telegram Webhook (/telegram/webhook) links customer Telegram chat_id to session
    const tgRes = await fetch(`${baseUrl}/telegram/webhook`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        update_id: 9001,
        message: {
          message_id: 1,
          from: { id: 777111, first_name: 'Akash', username: 'akash_bv' },
          chat: { id: 777111, type: 'private' },
          text: `/start ${asyncData.sessionToken}`,
        },
      }),
    });
    assert.equal(tgRes.status, 200);
    const tgData = await tgRes.json();
    assert.equal(tgData.ok, true);
    assert.equal(tgData.handled, true);
  });
});
