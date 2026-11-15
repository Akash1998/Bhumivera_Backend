const assert = require('node:assert/strict');
const Module = require('node:module');
const path = require('node:path');
const { describe, it } = require('node:test');

const modelPath = path.resolve(__dirname, '../models/affiliatePartnerModel.js');
const originalLoad = Module._load;
let insertedPartner;
let insertParams;
let dashboardPartner = null;
let dashboardSummary = null;
let dashboardSummaryQuery = '';

const fakePool = {
  async query(sql, params = []) {
    if (sql.includes('SELECT * FROM affiliate_partners WHERE user_id = ? LIMIT 1')) {
      return [dashboardPartner ? [dashboardPartner] : [], []];
    }
    if (sql.includes('SELECT key_name, value FROM settings')) {
      return [[], []];
    }
    if (sql.includes('SELECT COUNT(c.id) AS attributed_orders')) {
      dashboardSummaryQuery = sql;
      return [[dashboardSummary], []];
    }
    if (sql.includes('SELECT c.id, c.order_id, c.order_subtotal')) {
      return [[], []];
    }
    if (sql.includes('INSERT INTO affiliate_partners')) {
      insertParams = params;
      insertedPartner = {
        user_id: params[0],
        social_platform: params[1],
        social_handle: params[2],
        profile_url: params[3],
        follower_count: params[4],
        status: 'pending',
        referral_code: params[8],
        discount_percent: params[9],
        commission_share_percent: params[10],
      };
      return [{ insertId: 1 }, undefined];
    }
    if (sql.includes('SELECT * FROM affiliate_partners WHERE user_id = ?')) {
      return [[insertedPartner], []];
    }
    throw new Error(`Unexpected SQL in affiliate partner model test: ${sql}`);
  },
};

Module._load = function (request, parent, isMain) {
  if (parent?.filename === modelPath && request === '../config/db') return fakePool;
  return originalLoad.call(this, request, parent, isMain);
};
const { applyForPartner, getPartnerDashboard } = require('../models/affiliatePartnerModel');
Module._load = originalLoad;

describe('affiliate partner applications', () => {
  it('creates a unique reserved code while leaving a new application pending', async () => {
    const result = await applyForPartner({
      userId: 42,
      socialPlatform: 'Instagram',
      socialHandle: '@creator',
      profileUrl: 'https://instagram.com/creator',
      followerCount: 1000,
    });

    assert.equal(result.alreadyApplied, false);
    assert.equal(result.partner.status, 'pending');
    assert.match(result.partner.referral_code, /^BV[A-F0-9]{10}$/);
    assert.equal(insertParams[8], result.partner.referral_code);
    assert.equal(result.partner.discount_percent, 10);
    assert.equal(result.partner.commission_share_percent, 20);
  });

  it("reports collected impact contributions from the partner's attributed orders", async () => {
    dashboardPartner = { id: 17 };
    dashboardSummary = {
      attributed_orders: 2,
      funded_impact_contributions: 1,
      impact_amount: '250.00',
    };

    const dashboard = await getPartnerDashboard(42);

    assert.equal(Number(dashboard.summary.funded_impact_contributions), 1);
    assert.equal(Number(dashboard.summary.impact_amount), 250);
    assert.match(dashboardSummaryQuery, /LEFT JOIN impact_contributions ic/);
    assert.match(dashboardSummaryQuery, /ic\.status = 'collected'/);
    assert.match(dashboardSummaryQuery, /ic\.order_id = c\.order_id/);
  });
});
